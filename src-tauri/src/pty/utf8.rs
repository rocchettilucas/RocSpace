//! Byte-stream → text decoding for PTY output.
//!
//! A PTY read returns whatever bytes happened to be in the kernel buffer, which
//! has nothing to do with character boundaries: an 8 KiB read can end in the
//! middle of a 4-byte emoji. Decoding each read on its own with
//! `String::from_utf8_lossy` turns that split into two replacement characters —
//! permanent mojibake in the middle of otherwise fine output, and the agent
//! CLIs paint box-drawing and emoji constantly.
//!
//! `Utf8Stream` decodes across reads instead: it emits everything that is
//! complete and carries the dangling tail (at most 3 bytes) into the next read.

/// Incremental UTF-8 decoder for a byte stream delivered in arbitrary chunks.
#[derive(Debug, Default)]
pub struct Utf8Stream {
    /// The trailing bytes of a character whose remaining bytes have not
    /// arrived yet. Never longer than 3: a UTF-8 sequence is at most 4 bytes,
    /// and a sequence is only carried while it is incomplete.
    carry: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode `bytes`, prefixed by whatever the previous call could not
    /// finish. Returns every complete character; an incomplete trailing
    /// sequence is held back for the next call.
    ///
    /// Bytes that are invalid UTF-8 no matter what follows (a stray
    /// continuation byte, an overlong form) become U+FFFD immediately —
    /// carrying those would stall the stream waiting for a completion that
    /// cannot come.
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);

        let mut out = String::with_capacity(buf.len());
        let mut start = 0usize;
        loop {
            match std::str::from_utf8(&buf[start..]) {
                Ok(text) => {
                    out.push_str(text);
                    start = buf.len();
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&buf[start..start + valid_up_to])
                            .expect("prefix validated by from_utf8"),
                    );
                    match err.error_len() {
                        // Truly malformed: replace and keep going.
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            start += valid_up_to + bad;
                        }
                        // Unexpected end of input: the rest of this character
                        // is in the next read.
                        None => {
                            start += valid_up_to;
                            break;
                        }
                    }
                }
            }
        }

        self.carry = buf[start..].to_vec();
        out
    }

    /// EOF: emit whatever is still held back. There is no next read to
    /// complete it, so the dangling bytes can only be replaced.
    pub fn flush(&mut self) -> String {
        if self.carry.is_empty() {
            return String::new();
        }
        let carry = std::mem::take(&mut self.carry);
        String::from_utf8_lossy(&carry).into_owned()
    }

    /// How many bytes are waiting for their character to be completed. Exposed
    /// for the invariant test — nothing in the runtime needs it.
    #[cfg(test)]
    fn pending(&self) -> usize {
        self.carry.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Emoji, CJK, accented Latin, box drawing: everything an agent CLI paints
    /// that is not ASCII, plus ASCII around it.
    const SAMPLE: &str = "ok ✓ 你好 é ▛▀▜ 🚀 done";

    #[test]
    fn ascii_passes_through_unchanged() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.decode(b"hello world"), "hello world");
        assert_eq!(stream.pending(), 0);
    }

    #[test]
    fn a_character_split_across_two_reads_survives() {
        // The bug this module exists for: 🚀 is 4 bytes, and a read boundary
        // can land inside it.
        let rocket = "🚀".as_bytes();
        for split in 1..rocket.len() {
            let mut stream = Utf8Stream::new();
            let first = stream.decode(&rocket[..split]);
            let second = stream.decode(&rocket[split..]);
            assert_eq!(
                format!("{first}{second}"),
                "🚀",
                "split after {split} byte(s)"
            );
        }
    }

    #[test]
    fn a_stream_split_at_every_offset_reassembles_exactly() {
        let bytes = SAMPLE.as_bytes();
        for split in 0..=bytes.len() {
            let mut stream = Utf8Stream::new();
            let mut out = stream.decode(&bytes[..split]);
            out.push_str(&stream.decode(&bytes[split..]));
            out.push_str(&stream.flush());
            assert_eq!(out, SAMPLE, "split after {split} byte(s)");
        }
    }

    #[test]
    fn a_stream_fed_one_byte_at_a_time_reassembles_exactly() {
        let mut stream = Utf8Stream::new();
        let mut out = String::new();
        for byte in SAMPLE.as_bytes() {
            out.push_str(&stream.decode(&[*byte]));
        }
        out.push_str(&stream.flush());
        assert_eq!(out, SAMPLE);
    }

    #[test]
    fn nothing_is_held_back_once_a_character_completes() {
        let mut stream = Utf8Stream::new();
        stream.decode(&"🚀".as_bytes()[..2]);
        assert_eq!(stream.pending(), 2, "an incomplete emoji is carried");
        stream.decode(&"🚀".as_bytes()[2..]);
        assert_eq!(stream.pending(), 0);
    }

    #[test]
    fn the_carry_never_exceeds_three_bytes() {
        // The bound matters: the carry is prepended to every read, so an
        // unbounded one would be a slow leak on a stream of malformed bytes.
        let mut stream = Utf8Stream::new();
        for byte in 0u16..=255 {
            stream.decode(&[byte as u8]);
            assert!(stream.pending() <= 3, "byte {byte:#04x} grew the carry");
        }
    }

    #[test]
    fn malformed_bytes_do_not_stall_the_stream() {
        // A stray continuation byte can never be completed by what follows;
        // carrying it would swallow everything printed after it.
        let mut stream = Utf8Stream::new();
        let text = stream.decode(b"a\x80b");
        assert_eq!(text, "a\u{fffd}b");
        assert_eq!(stream.pending(), 0);
    }

    #[test]
    fn a_truncated_character_at_eof_is_replaced_not_dropped() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.decode(&"é".as_bytes()[..1]), "");
        assert_eq!(stream.flush(), "\u{fffd}");
        assert_eq!(stream.flush(), "", "flush drains the carry");
    }

    #[test]
    fn flushing_a_clean_stream_emits_nothing() {
        let mut stream = Utf8Stream::new();
        stream.decode(b"clean");
        assert_eq!(stream.flush(), "");
    }

    #[test]
    fn an_empty_read_is_not_an_end_of_stream() {
        // `read` returning 0 ends the loop in the runtime, but `decode(&[])`
        // must not be mistaken for EOF here: the carry has to survive it.
        let mut stream = Utf8Stream::new();
        stream.decode(&"你".as_bytes()[..1]);
        assert_eq!(stream.decode(&[]), "");
        assert_eq!(stream.decode(&"你".as_bytes()[1..]), "你");
    }
}
