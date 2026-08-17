// Cross-host constants for OAN delivery and waking

/** Main-session wake retry interval: in-flight requests usually finish within a few seconds */
export const OAN_MAIN_WAKE_RETRY_MS = 4_000;

/** Maximum retry window for main-session wakes: after it expires, the queued wake event and ledger reminders still remain */
export const OAN_MAIN_WAKE_MAX_AGE_MS = 600_000;

/** Sweep period for main-session wakes (the consuming side in the resident process) */
export const OAN_MAIN_WAKE_SWEEP_MS = 4_000;
