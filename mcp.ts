// mcp.ts: the Model Context Protocol endpoint (placeholder while REST and git are graded).
export async function handleMcp(_method: string, _headers: unknown, _body: Buffer, _base: string): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  return { status: 404, headers: {}, body: { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not implemented' } } };
}
