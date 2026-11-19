export const metadata = { title: "Author's Room" };
export const viewport = { width: 'device-width', initialScale: 1 };

const css = `
*{box-sizing:border-box}
.two-col{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px;align-items:start}
.two-col.wide{grid-template-columns:minmax(0,1fr) minmax(0,1.25fr)}
@media (max-width:820px){.two-col,.two-col.wide{grid-template-columns:minmax(0,1fr)}}
textarea,input,select{max-width:100%}
pre,blockquote,p{overflow-wrap:anywhere}
table{display:block;overflow-x:auto;max-width:100%}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <head><style dangerouslySetInnerHTML={{ __html: css }} /></head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
