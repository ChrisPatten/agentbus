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
import smtplib
import ssl
import sys
from email.mime.text import MIMEText

ICLOUD_SMTP_HOST = "smtp.mail.me.com"
ICLOUD_SMTP_PORT = 587
ICLOUD_USER = "peggy.pattenbot@icloud.com"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--from", dest="from_addr", required=True, help='e.g. "Peggy <peggy.pattenbot@icloud.com>"')
    p.add_argument("--to", required=True)
    p.add_argument("--subject", required=True)
    p.add_argument("--body", required=True)
    p.add_argument("--password", required=True, help="iCloud app-specific password for peggy.pattenbot@icloud.com")
    args = p.parse_args()

    msg = MIMEText(args.body)
    msg["Subject"] = args.subject
    msg["From"] = args.from_addr
    msg["To"] = args.to

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(ICLOUD_SMTP_HOST, ICLOUD_SMTP_PORT, timeout=20) as server:
            server.starttls(context=context)
            server.login(ICLOUD_USER, args.password)
            server.sendmail(ICLOUD_USER, [args.to], msg.as_string())
        print("Email sent.")
        return 0
    except Exception as exc:  # noqa: BLE001 - this is a last-resort script, log and exit non-zero
        print(f"Failed to send email: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
