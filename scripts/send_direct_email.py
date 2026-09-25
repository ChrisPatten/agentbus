#!/usr/bin/env python3
"""Minimal direct SMTP sender for Peggy's iCloud account.

Deliberately has ZERO dependency on AgentBus/bus-core being reachable — it
talks to iCloud's SMTP server directly. This exists purely as a last-resort
notification path for scripts/safe_restart.sh: if bus-core itself is the
thing that's down, the normal send_email MCP tool (which is served BY
bus-core) is unusable, so this script is how Peggy can still get a message
to Chris.

Not intended for routine use — the normal path for any in-process agent
turn is still mcp__agentbus__send_email.
"""
import argparse
import os
import smtplib
import ssl
import sys
from email.mime.text import MIMEText

ICLOUD_SMTP_HOST = "smtp.mail.me.com"
ICLOUD_SMTP_PORT = 587
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")


def get_setting(key: str) -> str | None:
    val = os.environ.get(key)
    if val:
        return val
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--from", dest="from_addr", help="Defaults to $DIRECT_EMAIL_FROM")
    p.add_argument("--to", help="Defaults to $DIRECT_EMAIL_TO")
    p.add_argument("--subject", required=True)
    p.add_argument("--body", help="Message body; reads stdin if omitted")
    p.add_argument("--password", help="Defaults to $ICLOUD_APP_PW_PEGGY")
    args = p.parse_args()

    body = args.body if args.body is not None else sys.stdin.read()
    password = args.password or get_setting("ICLOUD_APP_PW_PEGGY")
    user = get_setting("DIRECT_EMAIL_USER")
    from_addr = args.from_addr or get_setting("DIRECT_EMAIL_FROM")
    to_addr = args.to or get_setting("DIRECT_EMAIL_TO")
    missing = [n for n, v in [("ICLOUD_APP_PW_PEGGY", password), ("DIRECT_EMAIL_USER", user),
                              ("DIRECT_EMAIL_FROM", from_addr), ("DIRECT_EMAIL_TO", to_addr)] if not v]
    if missing:
        print(f"Missing settings (flag, env var, or agentbus/.env): {', '.join(missing)}", file=sys.stderr)
        return 1

    msg = MIMEText(body)
    msg["Subject"] = args.subject
    msg["From"] = from_addr
    msg["To"] = to_addr

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(ICLOUD_SMTP_HOST, ICLOUD_SMTP_PORT, timeout=20) as server:
            server.starttls(context=context)
            server.login(user, password)
            server.sendmail(user, [to_addr], msg.as_string())
        print("Email sent.")
        return 0
    except Exception as exc:  # noqa: BLE001 - this is a last-resort script, log and exit non-zero
        print(f"Failed to send email: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
