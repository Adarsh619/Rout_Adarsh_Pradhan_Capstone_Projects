import { model, Schema } from "mongoose";

// Payment provider events already handled. Razorpay may deliver the same event more than once (it retries until it
// gets a 2xx), so each event id is processed once; a failed one is processed again on the next delivery.
const webhookEventSchema = new Schema(
  {
    provider: { type: String, enum: ["razorpay"], required: true },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    status: { type: String, enum: ["processing", "processed", "ignored", "failed"], required: true },
    result: { type: String },
    error: { type: String },
    receivedAt: { type: Date, required: true },
    processedAt: { type: Date },
  },
  { timestamps: false },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export const WebhookEvent = model("WebhookEvent", webhookEventSchema);
