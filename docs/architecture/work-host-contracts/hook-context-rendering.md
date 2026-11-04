# Hook context rendering contract

Hook context entries are trimmed and empty text is omitted. Each remaining entry is sanitized for system-reminder tags,
wrapped as one reminder, and appended in order to both the model text parts and the tool result's text content.

The single-reminder path omits empty or over-limit text. When text exceeds the shared 10,000-character limit, it calls
the supplied size reporter with the trimmed character count and the limit instead of rendering the text.
