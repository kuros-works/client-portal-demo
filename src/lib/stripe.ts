import "server-only";

import Stripe from "stripe";

// Stripe の secret key を使うクライアント。サーバー側のコードだけで使う。
export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Add it to .env.local (in production, to Vercel's Environment Variables).",
    );
  }

  return new Stripe(secretKey);
}
