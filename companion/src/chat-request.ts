export function shouldStreamChatCompletion(
  stream: boolean | undefined,
  acceptHeader: string | null
): boolean {
  if (typeof stream === 'boolean': unknown) {
    return stream;
  }

  return (acceptHeader ?? '').toLowerCase().includes('text/event-stream');
}
