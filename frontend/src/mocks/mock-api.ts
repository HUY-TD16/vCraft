import fixtures from './fixtures.json';

export async function mockRequest(name: string): Promise<Response> {
  const fixture = fixtures.find(item => item.name === name);
  if (!fixture) throw new Error(`Unknown mock scenario: ${name}`);
  const { status, headers, body } = fixture.response;
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) responseHeaders.set(key, value);
  }
  if ('bodyBase64' in fixture.response && fixture.response.bodyBase64) {
    const bytes = Uint8Array.from(atob(fixture.response.bodyBase64), character => character.charCodeAt(0));
    return new Response(bytes, { status, headers: responseHeaders });
  }
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
