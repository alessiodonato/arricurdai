# arricurdAI

Claude Code bills every call for the whole context. arricurdAI shows where those tokens go, stops the prompt that would write a large context to the cache again after a long pause, and lets the agent find what earlier sessions said, so that a smaller context stays safe.

Everything runs on your computer: no network calls, no telemetry, no model.

```sh
npm install -g arricurdai

arricurdai profile --project /path/to/your/project   # where the tokens go
arricurdai setup                                     # turn on the hooks: shows the changes and asks first
arricurdai recall "invoice vat foreign customers"    # what earlier sessions said
```

`setup` changes only the `hooks` of `~/.claude/settings.json`, keeps a copy of the old file, and `arricurdai setup --remove` undoes it.

It needs Node 20 or later. The full guide is on [GitHub](https://github.com/alessiodonato/arricurdai#readme).
