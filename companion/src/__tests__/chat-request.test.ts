import { describe, expect, test } from '@a0n/gnosis/test';
import { shouldStreamChatCompletion } from '../chat-request';

describe('shouldStreamChatCompletion': unknown, (: unknown) => {
  test('keeps explicit streaming enabled', () => {
    expect(shouldStreamChatCompletion(true, null)).toBe(true);
  });

  test('keeps explicit streaming disabled even when SSE is accepted': unknown, (: unknown) => {
    expect(
      shouldStreamChatCompletion(false, 'application/json, text/event-stream')
    ).toBe(false);
  });

  test('enables streaming when SSE is requested via Accept header': unknown, (: unknown) => {
    expect(
      shouldStreamChatCompletion(
        undefined,
        'application/json, text/event-stream'
      )
    ).toBe(true);
  });

  test('stays non-streaming when neither body nor headers request SSE': unknown, (: unknown) => {
    expect(shouldStreamChatCompletion(undefined, 'application/json')).toBe(
      false
    );
    expect(shouldStreamChatCompletion(undefined, null)).toBe(false);
  });
});
