"""E-mail sending for ParkEase (password reset links, contact messages, receipts).

Configure with environment variables:

    PARKEASE_SMTP_HOST       e.g. smtp.gmail.com       (required to send real e-mail)
    PARKEASE_SMTP_PORT       default 587
    PARKEASE_SMTP_USER       SMTP login
    PARKEASE_SMTP_PASSWORD   SMTP password / app password
    PARKEASE_SMTP_SECURITY   starttls (default) | ssl | none
    PARKEASE_MAIL_FROM       "ParkEase <no-reply@yourdomain.com>"  (defaults to the SMTP user)

If PARKEASE_SMTP_HOST is not set nothing is sent: the message is printed to the console and appended to
instance/outbox.log instead, so the app still works on a development machine.
"""
import logging
import os
import smtplib
import ssl
import threading
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

import database as db

log = logging.getLogger("parkease.mail")


def is_configured() -> bool:
    return bool(os.environ.get("PARKEASE_SMTP_HOST"))


def _sender() -> str:
    return os.environ.get("PARKEASE_MAIL_FROM") or os.environ.get("PARKEASE_SMTP_USER") or "ParkEase <no-reply@localhost>"


def _clean_header(value: str) -> str:
    # Header injection guard: no line breaks in any header value.
    return " ".join(str(value).split())


def build_message(to: str, subject: str, text: str, reply_to: str | None = None) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = _sender()
    msg["To"] = _clean_header(to)
    msg["Subject"] = _clean_header(subject)
    if reply_to:
        name, addr = parseaddr(_clean_header(reply_to))
        if addr:
            msg["Reply-To"] = formataddr((name, addr))
    msg.set_content(text)
    return msg


def _deliver(msg: EmailMessage) -> bool:
    host = os.environ.get("PARKEASE_SMTP_HOST")
    if not host:
        # Development fallback: show the e-mail instead of sending it.
        body = f"--- {datetime.now():%Y-%m-%d %H:%M:%S} ---\nTo: {msg['To']}\nSubject: {msg['Subject']}\n\n" \
               f"{msg.get_content()}\n"
        print("\n[ParkEase e-mail - SMTP not configured, not sent]\n" + body)
        try:
            db.INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
            with open(db.INSTANCE_DIR / "outbox.log", "a", encoding="utf-8") as fh:
                fh.write(body + "\n")
        except OSError:
            pass
        return False
    port = int(os.environ.get("PARKEASE_SMTP_PORT", "587"))
    security = os.environ.get("PARKEASE_SMTP_SECURITY", "starttls").lower()
    user, password = os.environ.get("PARKEASE_SMTP_USER"), os.environ.get("PARKEASE_SMTP_PASSWORD")
    try:
        if security == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(host, port, timeout=20)
        with server:
            if security == "starttls":
                server.starttls(context=ssl.create_default_context())
            if user:
                server.login(user, password or "")
            server.send_message(msg)
        return True
    except (smtplib.SMTPException, OSError) as exc:
        log.error("Could not send e-mail to %s: %s", msg["To"], exc)
        return False


def send_mail(to: str, subject: str, text: str, reply_to: str | None = None, wait: bool = False) -> bool:
    """Send a plain-text e-mail. By default it is sent in a background thread so the web request is not
    slowed down (which would also reveal whether an address exists). Returns True only when wait=True
    and the message was really handed to an SMTP server."""
    msg = build_message(to, subject, text, reply_to)
    if wait:
        return _deliver(msg)
    threading.Thread(target=_deliver, args=(msg,), daemon=True).start()
    return False
