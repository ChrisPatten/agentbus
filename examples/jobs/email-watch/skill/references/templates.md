# Email watch templates

Fill these in exactly; drop a section with nothing in it.

## Message to the owner (only when something is actionable)

```
<Most important item, one sentence, with what the owner ought to do.>

- <Sender> — <subject>: <why it matters, one sentence>
- <Sender> — <subject>: <why it matters>
```

Three to five lines for a light scan, never more than about ten. Exact amounts and dates.

## Log entry — something found

```markdown
## [HH:MM] Email scan
- <sender — what it was — what was done or is pending>
- Follow-up: <what the owner owes whom, by when>
- Bill: <payee $amount due YYYY-MM-DD>
- Sent to owner: <yes — one-line gist | no>
```

## Log entry — nothing actionable

```markdown
**[HH:MM] Email scan**: nothing actionable.
```

One line only. Log files are re-read on every turn for days, so a paragraph per quiet scan is expensive.
