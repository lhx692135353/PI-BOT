/** Allow slow models up to ten minutes to answer a conversation turn. */
export const CONVERSATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Model requests and idle detection must not expire before the conversation. */
export const MODEL_TIMEOUT_MS = CONVERSATION_TIMEOUT_MS;
