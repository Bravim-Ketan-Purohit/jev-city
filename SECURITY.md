# Security

This project has no backend of its own and stores no user data. The hosted demo is a static build with no API keys in it.

If you run it yourself, your TypeSafe API key lives in a local `.env` file that git ignores. It is read only by the local proxy in `server/`, and it never reaches the browser. Never commit it, and never put it in a hosted deployment that strangers can reach, because anyone visiting could then spend your tokens.

Found a security problem? Please contact me through my GitHub profile rather than opening a public issue.
