/** @type {import('next').NextConfig} */
// Static export: the app is plain files that call Supabase directly, so it runs
// with `npm run dev` on your PC or on any static host. No server secrets.
// NEXT_PUBLIC_BASE_PATH is set only for GitHub Pages (the site lives under /authors-room).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
export default { reactStrictMode: true, output: 'export', images: { unoptimized: true }, trailingSlash: true, basePath };
