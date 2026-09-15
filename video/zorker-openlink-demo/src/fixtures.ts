export const INITIAL_PROMPT='Build a landing page for Forma, an architecture studio. Use a warm neutral palette, generous spacing, and a clear project inquiry button.';
export const REVISED_PROMPT='Build a landing page for Forma, an architecture studio. Use an electric blue palette, generous spacing, and a clear project inquiry button.';
export const USER_MESSAGE_ID='demo-user-message-1';
export const SAMPLE_CODE=[
  'export default function Home() {',
  '  return (',
  '    <main className="forma-page">',
  '      <Navigation brand="forma" />',
  '      <section className="studio-hero">',
  '        <div>',
  '          <p>Independent architecture studio</p>',
  '          <h1>Space for a different perspective.</h1>',
  '          <p>Thoughtful spaces. Lasting impressions.</p>',
  '          <a href="mailto:hello@example.com">',
  '            Start a project',
  '          </a>',
  '        </div>',
  '        <ArchitecturalStudy />',
  '      </section>',
  '    </main>',
  '  );',
  '}',
];
export function stateAt(frame:number) {
  const submitted=frame>=245;
  const working=submitted && frame<600;
  const preview=frame>=600;
  const code=frame>=800 && frame<990;
  const editing=frame>=1020 && frame<1185;
  const resending=frame>=1185 && frame<1220;
  const revised=frame>=1220;
  const finished=frame>=1320;
  return {submitted,working,preview,code,editing,resending,revised,finished};
}
