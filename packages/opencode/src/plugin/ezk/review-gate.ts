import { ReviewGate } from "@opencode-ai/core/ezk/review-gate"

// Kept in a tiny leaf module so session/prompt can share the gate without
// importing the rest of the Ezk runtime during server startup.
export const reviewGate = new ReviewGate()
