// /robots.txt — standard crawler directives, plus a pointer to /llms.txt
// for AI agents that probe robots.txt first when they don't know the
// llms.txt convention. See routes/llms[.]txt.tsx for the why.
export async function loader() {
  const body = `User-agent: *
Allow: /

# AI agents: see /llms.txt for onboarding instructions.
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
