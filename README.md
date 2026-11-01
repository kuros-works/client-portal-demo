# Client Portal

A secure, invite-only portal where clients can track the status of their projects and download deliverables. Admins manage projects, invite clients, and share files from a single dashboard.

**Live demo:** https://client-portal-demo-chi.vercel.app

## Demo access

Sign-in is invite-only, so the live demo can't be opened without an account. Instead, the project is shown with a video and screenshots. A demo login is available on request.

The live demo runs in Stripe test mode. No real payments are processed.

To try the payment flow with a demo login, use the Stripe test card `4242 4242 4242 4242` with any future expiry date, any CVC, and any postal code.

## Features

- **Passwordless sign-in** with email magic links. Only invited users can sign in; public sign-up is disabled.
- **Client view:** clients see only their own projects, each project's status (In progress / In review / Delivered), and its files.
- **Per-project payments:** an admin can set an amount on a project, and the client pays it with Stripe Checkout. Files stay locked until the project is paid.
- **Admin dashboard:** create projects, set amounts, update status, invite clients, and upload, download, or delete files.

## Payments (Stripe)

Each project can carry one invoice, in USD, paid by card.

The live demo runs in Stripe test mode. No real payments are processed.

1. An admin sets an amount on the project (minimum $0.50). A project with no amount is not billed.
2. The client opens the project and starts a Stripe Checkout session (English, card only, expires after 30 minutes). The amount is read from the database, never from the browser.
3. After payment, Stripe calls the webhook. The webhook marks the project as paid.
4. Until the project is paid, its files are hidden from the client. This is enforced by RLS on both the table and Storage, not only in the UI.

Only the webhook (using the service role) can write `payment_status`, `paid_at`, and `stripe_session_id`. A database trigger also blocks changing the amount of a paid project, for every role.

### Webhook safety

- **Signature first.** The request body is verified against the `stripe-signature` header before anything else happens. If it can't be verified, the route returns 400 and does nothing.
- **Idempotent.** Each Stripe event is recorded by `event_id`, so a retried event is not processed twice.
- **Checks before marking paid.** The project must exist, and the amount and currency (USD) must match. If anything doesn't match, if the project is already paid, or if the project can't be found, the event is recorded and `paid` is not overwritten. Refunds are handled manually.
- **Record last.** The event is recorded only after the project is updated, so a failed update never gets marked as handled.
- **Retries.** Temporary failures return 500, so Stripe sends the event again. Failures that retrying can't fix return 200.
- **Card only.** Checkout is limited to card, because delayed payment methods can't be picked up by this webhook.

## Architecture

```
Browser ──► Next.js on Vercel (App Router, Server Actions, route handlers)
               │
               ├──► Supabase Auth      magic-link sign-in, invite-only
               ├──► Supabase Postgres  profiles, projects, project_files, stripe_events (RLS on every table)
               ├──► Supabase Storage   private bucket, signed URLs that expire after 60 seconds
               └──► Stripe Checkout    one session per project
                          │
                          ▼  checkout.session.completed
                    /api/stripe/webhook ──► verify signature ──► update project to paid
                                            (service role, server-side only)
```

## Scope / Non-goals

This is a focused demo, so some things are left out on purpose:

- No notification emails.
- No large files (uploads are limited to 4 MB).
- No subscriptions, installments, or in-app refunds. Payments are one invoice per project, in USD.
- No custom design system or CMS.

## Security design

- **Row Level Security (RLS)** on every table. Admins have full access; clients can only read their own projects. Clients can read a project's files only when the project has no amount or is paid.
- **Writes are admin-only,** with one exception: the Stripe webhook (service role) is the only writer of payment columns. Column-level grants stop even admins from writing them.
- **Server-side role checks.** Every admin page and Server Action verifies the user's role in the database before reading or writing data.
- **Private storage.** Files are stored in a private Supabase Storage bucket and are never publicly accessible.
- **Short-lived download links.** Each download goes through a server route that checks access under RLS, then redirects to a signed URL that expires after 60 seconds.
- **No information leaks.** A project or file that doesn't exist and one the user can't access both return the same 404. The sign-in form shows the same message whether or not an account exists.
- **Secrets stay on the server.** `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` are used only in server-only code and are never exposed to the browser.

## Testing

Access control was tested in production by opening each other's project URLs and file download URLs directly, from three directions: signed out, Client A, and Client B. All 10 checks passed.

Also verified:

- A signed download URL stops working after 60 seconds.
- **Local, webhook:** the webhook returns 200 and the project becomes `paid`. Re-sending the same event with `stripe events resend` does not process it twice.
- **Production, payment:** paying with a test card marks the project as `paid` and lifts the file restriction on the project page.
- **Production, duplicate payment:** two Checkout sessions were opened for the same unpaid project and both were paid. The second payment was only recorded and did not overwrite the project. Stripe delivered both events successfully, with 0 failures.

## Building with AI, reviewed by a human

This project was built with Claude Code. I designed the data model and access rules, and reviewed every change myself, especially the SQL and RLS policies.

One example: in `0001_init.sql`, the client read policy on Storage used an unqualified `name` inside a subquery on `projects`. Postgres resolved it to `projects.name` (the project's name) instead of `storage.objects.name` (the file path). The SQL ran without errors and looked correct, but clients could not read any files, including their own.

I found this while testing client downloads and fixed it before any client used the portal. The fix only qualifies the column name:

```sql
-- before
where p.id::text = (storage.foldername(name))[1]

-- after
where p.id::text = (storage.foldername(storage.objects.name))[1]
```

The fix is in `supabase/migrations/0002_fix_storage_client_policy.sql` (commit `e53fdb7`). After the fix, I confirmed in production that a client can download their own files and gets a 404 for another client's files.

The lesson: AI-written RLS can run without errors and still be wrong, so I test as real users, on both the allowed and the denied side, before shipping.

## Where to look

- RLS policies and table definitions: `supabase/migrations/` (`0001_init.sql`, `0002_fix_storage_client_policy.sql`, and `0003_project_payments.sql` for payments)
- Checkout session creation: `src/app/projects/[id]/actions.ts`
- Stripe webhook: `src/app/api/stripe/webhook/route.ts`
- File download handling: `src/app/files/[id]/download/route.ts`

## Tech stack

- [Next.js](https://nextjs.org) 16 (App Router), React 19, TypeScript
- [Tailwind CSS](https://tailwindcss.com) v4, [shadcn/ui](https://ui.shadcn.com)
- [Supabase](https://supabase.com) (Auth, Postgres, Storage)
- [Stripe](https://stripe.com) (Checkout and webhooks)
- Deployed on [Vercel](https://vercel.com)

## Running locally

This project uses **pnpm** only.

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create a Supabase project, then run the SQL files in `supabase/migrations/` in order (for example, in the Supabase SQL Editor). This creates the tables, RLS policies, and the private storage bucket.

3. In Supabase Auth settings:
   - Disable new user sign-ups.
   - Add `http://localhost:3000/auth/callback` to the allowed redirect URLs.

4. Create `.env.local` with the following variables:

   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   STRIPE_SECRET_KEY=
   STRIPE_WEBHOOK_SECRET=
   ```

   Use a Stripe test-mode secret key for `STRIPE_SECRET_KEY`. `STRIPE_WEBHOOK_SECRET` comes from the next step.

5. Forward Stripe events to your local server with the [Stripe CLI](https://docs.stripe.com/stripe-cli):

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

   The command prints a signing secret that starts with `whsec_`. Set it as `STRIPE_WEBHOOK_SECRET` in `.env.local`, then restart the dev server. To replay an event, run `stripe events resend <event_id>`.

6. Start the development server:

   ```bash
   pnpm dev
   ```

7. Create the first admin: add a user in the Supabase dashboard, then set that user's `profiles.role` to `admin`.

Open http://localhost:3000 and sign in with that user's email.

For production:

- Configure a custom SMTP provider in Supabase, since the built-in email service has a low sending limit.
- Add a Stripe webhook endpoint for `https://<your-domain>/api/stripe/webhook` that listens to `checkout.session.completed`, and use its signing secret as `STRIPE_WEBHOOK_SECRET`.
