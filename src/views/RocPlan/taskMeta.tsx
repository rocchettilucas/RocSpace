/** What a status and a priority look like, in one place.
 *
 *  The board draws each of these three or four times over (column header, count
 *  badge, card pill, the modal's radio row, an aria-label), and a `Record` over
 *  the union is what stops a new status being half-added: TypeScript refuses the
 *  table until every case has a label, an icon and a colour.
 *
 *  Colours are `--rs-*` theme variables rather than the teardown's hard-coded
 *  tints. Everything else in RocSpace re-colours with the theme and a kanban
 *  column has no more reason to be exempt than a status pill does. */

import {
  Circle,
  CircleCheckBig,
  CircleX,
  Clock,
  Eye,
  type LucideIcon,
} from "lucide-react";
import type { RocTaskPriority, RocTaskStatus } from "@/lib/bindings";

export interface ColumnMeta {
  label: string;
  icon: LucideIcon;
  /** CSS colour for the column's top border, icon and count badge. */
  tint: string;
}

export const COLUMN_META: Record<RocTaskStatus, ColumnMeta> = {
  todo: { label: "To Do", icon: Circle, tint: "var(--rs-text-3)" },
  in_progress: { label: "In Progress", icon: Clock, tint: "var(--rs-primary)" },
  in_review: { label: "In Review", icon: Eye, tint: "var(--rs-warning)" },
  complete: {
    label: "Complete",
    icon: CircleCheckBig,
    tint: "var(--rs-success)",
  },
  cancelled: { label: "Cancelled", icon: CircleX, tint: "var(--rs-danger)" },
};

export interface PriorityMeta {
  label: string;
  /** CSS colour for the card's left accent bar and its priority pill. */
  tint: string;
}

export const PRIORITY_META: Record<RocTaskPriority, PriorityMeta> = {
  critical: { label: "Critical", tint: "var(--rs-danger)" },
  high: { label: "High", tint: "var(--rs-warning)" },
  medium: { label: "Medium", tint: "var(--rs-primary)" },
  low: { label: "Low", tint: "var(--rs-text-3)" },
};

/** A low-alpha wash of `tint`, for a pill's fill behind its own text. */
export const tintedFill = (tint: string, percent = 14): string =>
  `color-mix(in srgb, ${tint} ${percent}%, transparent)`;
