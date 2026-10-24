import { describe, expect, test } from '@a0n/gnosis/test';
import { shouldStreamChatCompletion } from '../chat-request';

describe('shouldStreamChatCompletion', () => {
  test('keeps explicit streaming enabled', () => {
    expect(shouldStreamChatCompletion(true, null)).toBe(true);
  });

  test('keeps explicit streaming disabled even when SSE is accepted', () => {
    expect(
      shouldStreamChatCompletion(false, 'application/json, text/event-stream')
    ).toBe(false);
  });

  test('enables streaming when SSE is requested via Accept header', () => {
    expect(
      shouldStreamChatCompletion(
        undefined,
        'application/json, text/event-stream'
      )
    ).toBe(true);
  });

  test('stays non-streaming when neither body nor headers request SSE', () => {
    expect(shouldStreamChatCompletion(undefined, 'application/json')).toBe(
      false
    );
    expect(shouldStreamChatCompletion(undefined, null)).toBe(false);
  });
});
