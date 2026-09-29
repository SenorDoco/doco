// /robots.txt — standard crawler directives, plus a pointer to the home
// page for AI agents that probe robots.txt first: the agent instructions
// live there.
export async function loader() {
  const body = `User-agent: *
Allow: /

# AI agents: the instructions to use Doco are on the home page, /.
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
