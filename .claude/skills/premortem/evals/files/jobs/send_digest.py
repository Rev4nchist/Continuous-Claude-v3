"""Send the daily digest email to every active subscriber."""
import os
import sys
from datetime import date

from app.db import connect
from app.mail import send

TEMPLATE_DIR = "/var/app/digest/templates"


def template_dir():
    # The new host keeps templates next to the code. Fall back to that when the old path is absent.
    if os.path.exists(TEMPLATE_DIR):
        return TEMPLATE_DIR
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")


def main():
    db = connect()
    today = date.today().isoformat()
    subscribers = db.query("SELECT id, email FROM subscribers WHERE active = true")
    for sub in subscribers:
        body = render(template_dir(), sub, today)
        send(sub["email"], f"Your digest for {today}", body)
        db.execute("INSERT INTO digest_log (subscriber_id, day) VALUES (%s, %s)", (sub["id"], today))
    return 0


def render(path, sub, day):
    with open(os.path.join(path, "digest.html"), encoding="utf-8") as fh:
        return fh.read().replace("{{day}}", day).replace("{{email}}", sub["email"])


if __name__ == "__main__":
    sys.exit(main())
