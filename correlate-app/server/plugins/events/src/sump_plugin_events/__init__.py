"""correlate-app's event engine plugin (REQ-000043-sJpO9KMY).

Events evaluated on the Sump's live Redis streams, edge-triggered, by a
supervised background task; registered through the `sump.plugins` entry
point. Ported from cttc's gateway engine under decision D7.
"""

__version__ = "0.1.0"
