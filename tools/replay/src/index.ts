/**
 * Deterministic replay runner for CI.
 *
 * Replays a recorded command list against a seed and asserts identical state
 * hashes. Implemented once the simulation core lands in T0.2.
 */

export const REPLAY_TOOL_NAME = '@blockwork/replay'
