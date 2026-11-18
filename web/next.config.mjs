/** @type {import('next').NextConfig} */
// Static export: the app is plain files that call Supabase directly, so it runs
// with `npm run dev` on your PC or on any static host. No server secrets.
export default { reactStrictMode: true, output: 'export', images: { unoptimized: true } };
