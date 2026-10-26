# Client Portal

A secure, invite-only portal where clients can track the status of their projects and download deliverables. Admins manage projects, invite clients, and share files from a single dashboard.

**Live demo:** https://client-portal-demo-chi.vercel.app

Access is invite-only.

## Features

- **Passwordless sign-in** with email magic links. Only invited users can sign in; public sign-up is disabled.
- **Client view:** clients see only their own projects, each project's status (In progress / In review / Delivered), and its files.
- **Admin dashboard:** create projects, update their status, invite clients, and upload, download, or delete files.

## Security design

- **Row Level Security (RLS)** on every table. Admins have full access; clients can only read their own projects and those projects' files. All writes are admin-only.
- **Server-side role checks.** Every admin page and Server Action verifies the user's role in the database before reading or writing data.
- **Private storage.** Files are stored in a private Supabase Storage bucket and are never publicly accessible.
- **Short-lived download links.** Each download goes through a server route that checks access under RLS, then redirects to a signed URL that expires after 60 seconds.
- **No information leaks.** A project or file that doesn't exist and one the user can't access both return the same 404. The sign-in form shows the same message whether or not an account exists.
- **Service role key stays on the server.** `SUPABASE_SERVICE_ROLE_KEY` is used only in server-only code (for inviting clients) and is never exposed to the browser.

## Testing

Access control was tested in production with two client accounts (Client A and Client B), in both directions:

- Neither client could see the other's projects in their project list.
- Opening the other client's project URL directly returned a 404.
- Opening the other client's file download URL directly returned a 404.

Also verified in production:

- When signed out, opening a project or file download URL directly redirects to the sign-in page.
- A signed download URL stops working once it expires after 60 seconds.

## Tech stack

- [Next.js](https://nextjs.org) 16 (App Router), React 19, TypeScript
- [Tailwind CSS](https://tailwindcss.com) v4, [shadcn/ui](https://ui.shadcn.com)
- [Supabase](https://supabase.com) (Auth, Postgres, Storage)
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
   ```

5. Start the development server:

   ```bash
   pnpm dev
   ```

6. Create the first admin: add a user in the Supabase dashboard, then set that user's `profiles.role` to `admin`.

Open http://localhost:3000 and sign in with that user's email.

For production, configure a custom SMTP provider in Supabase, since the built-in email service has a low sending limit.
