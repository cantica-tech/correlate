# Sump plugin: events

The Sump's event engine (REQ-000043-sJpO9KMY). Under decision D7, events run in
the Sump only. The app edits them and shows their firings, and never evaluates
a condition.

- An event watches one data stream: all its containers, or named ones, and
  its host when asked. It has metric conditions (cpu, mem or net against a
  number) and log conditions (a regex), matched on any or all.
- It fires on an edge, once per change from not met to met
  (`br-EVENT-000004-sJpO9KMY`). A metric condition checks every watched
  series whose latest sample is at most 15 s old; a log condition reads every
  line appended since its stored position, which starts at the stream's tail.
- Events, their latch and their log positions are kept in the Sump's Redis
  (`sump:events:<id>`), so they survive a restart. Each firing is added to the
  bounded stream `sump:events:firings`.
- The evaluation loop is a background task, supervised by the Sump: a crash
  restarts it with backoff and never stops the Sump (`br-PLUGIN-000006`).

The HTTP API and ownership come with Item 46, actions with Item 47.
