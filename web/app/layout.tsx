export const metadata = { title: "Author's Room" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
