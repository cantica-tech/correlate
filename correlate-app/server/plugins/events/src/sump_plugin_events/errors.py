"""The events plugin's refusal (REQ-000043-sJpO9KMY), in its own module so the
model and the schedule both raise it without importing each other."""


class InvalidEvent(ValueError):
    """An event the Sump refuses, with the reason."""
