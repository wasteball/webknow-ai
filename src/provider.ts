export const MODEL_ENDPOINT =
  import.meta.env.MODE === 'test'
    ? 'http://127.0.0.1:4173/chat/completions'
    : 'https://api.deepseek.com/chat/completions';

export const MODEL_HOST_PERMISSION =
  import.meta.env.MODE === 'test' ? 'http://127.0.0.1:4173/*' : 'https://api.deepseek.com/*';
