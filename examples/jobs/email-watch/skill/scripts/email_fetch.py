#!/usr/bin/env python3
"""Fetch recent mail over IMAP and print it as JSON.

Usage: email_fetch.py [hours_back] [max_messages]      (defaults: 4, 50)

Environment:
  IMAP_HOST       e.g. imap.gmail.com
  IMAP_USER       account name
  IMAP_PASSWORD   an app password, not your main password
  IMAP_FOLDER     default INBOX

Output: {"count": N, "emails": [{"from", "subject", "date", "body"}]}
Bodies are plain text, truncated to 4000 characters. Standard library only.
"""
import email
import imaplib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime

BODY_LIMIT = 4000


def decode(value):
    return str(make_header(decode_header(value or "")))


def plain_body(msg):
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get_filename():
                return decode_part(part)
        return ""
    return decode_part(msg) if msg.get_content_type() == "text/plain" else ""


def decode_part(part):
    payload = part.get_payload(decode=True) or b""
    return payload.decode(part.get_content_charset() or "utf-8", errors="replace")


def main():
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 4
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    try:
        host, user, password = (os.environ[k] for k in ("IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"))
    except KeyError as missing:
        print(json.dumps({"error": f"{missing.args[0]} is not set"}))
        return 1

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    conn = imaplib.IMAP4_SSL(host)
    conn.login(user, password)
    conn.select(os.environ.get("IMAP_FOLDER", "INBOX"), readonly=True)

    # IMAP SINCE has day granularity; filter by exact time below.
    since = (cutoff - timedelta(days=1)).strftime("%d-%b-%Y")
    _, data = conn.search(None, "SINCE", since)
    ids = data[0].split()[-limit * 3:]

    emails = []
    for msg_id in reversed(ids):
        _, fetched = conn.fetch(msg_id, "(BODY.PEEK[])")
        msg = email.message_from_bytes(fetched[0][1])
        try:
            sent = parsedate_to_datetime(msg["Date"])
            if sent.tzinfo is None:
                sent = sent.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
        if sent < cutoff:
            continue
        emails.append({
            "from": decode(msg["From"]),
            "subject": decode(msg["Subject"]),
            "date": sent.isoformat(),
            "body": plain_body(msg)[:BODY_LIMIT],
        })
        if len(emails) >= limit:
            break
    conn.logout()
    print(json.dumps({"count": len(emails), "emails": emails}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
