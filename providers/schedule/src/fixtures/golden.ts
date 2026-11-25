import type { GoldenFixture } from "@sourcefed/sdk";

/** What the pre-SDK schedule provider did at 0a1a5e7, recorded so the SDK port must reproduce it exactly. */
export const SCHEDULE_GOLDEN: GoldenFixture = {
  provider: "schedule",
  recordedFrom: "0a1a5e7",
  base: "",
  cases: [
    {
      name: "priming",
      now: "2026-11-18T12:00:30.000Z",
      build: {
        name: "backup",
        sourceType: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      cursor: null,
      replies: [],
      requests: [],
      source: {
        type: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      key: "schedule:backup:30 * * * *:Asia/Kolkata",
      label: "backup",
      detail: " 30 * * * * Asia/Kolkata",
      describe: "Schedule backup (30 * * * *)",
      icon: "󰃰",
      defaultPollIntervalSec: 15,
      schema: {
        description:
          "A cron schedule: schedule.fired at each time, or one schedule.missed for times that came while sourcefed was stopped",
        properties: {
          cron: {
            type: "string",
            minLength: 1,
            description:
              "A cron expression, e.g. '0 2 * * *' for 02:00 every day",
          },
          job: {
            type: "string",
            minLength: 1,
            description: "The job's name, carried by every event's subject",
          },
          timezone: {
            type: "string",
            description:
              "An IANA time zone, e.g. 'Asia/Kolkata'; the Mac's own when left out",
          },
        },
        required: ["cron", "job"],
      },
      events: [],
      cursorAfter: {
        checkedAt: "2026-11-18T12:00:30.000Z",
      },
      terminal: false,
    },
    {
      name: "on-time",
      now: "2026-11-18T13:00:45.000Z",
      build: {
        name: "backup",
        sourceType: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      cursor: {
        checkedAt: "2026-11-18T12:00:30.000Z",
      },
      replies: [],
      requests: [],
      source: {
        type: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      key: "schedule:backup:30 * * * *:Asia/Kolkata",
      label: "backup",
      detail: " 30 * * * * Asia/Kolkata",
      describe: "Schedule backup (30 * * * *)",
      icon: "󰃰",
      defaultPollIntervalSec: 15,
      schema: {
        description:
          "A cron schedule: schedule.fired at each time, or one schedule.missed for times that came while sourcefed was stopped",
        properties: {
          cron: {
            type: "string",
            minLength: 1,
            description:
              "A cron expression, e.g. '0 2 * * *' for 02:00 every day",
          },
          job: {
            type: "string",
            minLength: 1,
            description: "The job's name, carried by every event's subject",
          },
          timezone: {
            type: "string",
            description:
              "An IANA time zone, e.g. 'Asia/Kolkata'; the Mac's own when left out",
          },
        },
        required: ["cron", "job"],
      },
      events: [
        {
          source: {
            type: "schedule",
            cron: "30 * * * *",
            job: "backup",
            timezone: "Asia/Kolkata",
          },
          kind: "schedule.fired",
          id: "schedule.fired:backup:2026-11-18T18:30:00+05:30",
          at: "2026-11-18T18:30:00+05:30",
          summary: "Schedule backup fired for 2026-11-18T18:30:00+05:30",
          actionable: true,
          subject: {
            type: "schedule",
            key: "backup",
            job: "backup",
            at: "2026-11-18T18:30:00+05:30",
            cron: "30 * * * *",
            timezone: "Asia/Kolkata",
          },
        },
      ],
      cursorAfter: {
        checkedAt: "2026-11-18T13:00:45.000Z",
      },
      terminal: false,
    },
    {
      name: "missed",
      now: "2026-11-18T16:30:00.000Z",
      build: {
        name: "backup",
        sourceType: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      cursor: {
        checkedAt: "2026-11-18T13:00:45.000Z",
      },
      replies: [],
      requests: [],
      source: {
        type: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      key: "schedule:backup:30 * * * *:Asia/Kolkata",
      label: "backup",
      detail: " 30 * * * * Asia/Kolkata",
      describe: "Schedule backup (30 * * * *)",
      icon: "󰃰",
      defaultPollIntervalSec: 15,
      schema: {
        description:
          "A cron schedule: schedule.fired at each time, or one schedule.missed for times that came while sourcefed was stopped",
        properties: {
          cron: {
            type: "string",
            minLength: 1,
            description:
              "A cron expression, e.g. '0 2 * * *' for 02:00 every day",
          },
          job: {
            type: "string",
            minLength: 1,
            description: "The job's name, carried by every event's subject",
          },
          timezone: {
            type: "string",
            description:
              "An IANA time zone, e.g. 'Asia/Kolkata'; the Mac's own when left out",
          },
        },
        required: ["cron", "job"],
      },
      events: [
        {
          source: {
            type: "schedule",
            cron: "30 * * * *",
            job: "backup",
            timezone: "Asia/Kolkata",
          },
          kind: "schedule.missed",
          id: "schedule.missed:backup:2026-11-18T21:30:00+05:30",
          at: "2026-11-18T21:30:00+05:30",
          summary:
            "Schedule backup missed 3 times; the latest was 2026-11-18T21:30:00+05:30",
          body: "Sourcefed was not running, or the Mac was asleep, when these times came. This one event stands for all of them.",
          actionable: true,
          subject: {
            type: "schedule",
            key: "backup",
            job: "backup",
            at: "2026-11-18T21:30:00+05:30",
            cron: "30 * * * *",
            timezone: "Asia/Kolkata",
            missed: 3,
          },
        },
      ],
      cursorAfter: {
        checkedAt: "2026-11-18T16:30:00.000Z",
      },
      terminal: false,
    },
    {
      name: "late-single",
      now: "2026-11-18T17:10:00.000Z",
      build: {
        name: "backup",
        sourceType: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      cursor: {
        checkedAt: "2026-11-18T16:30:00.000Z",
      },
      replies: [],
      requests: [],
      source: {
        type: "schedule",
        cron: "30 * * * *",
        job: "backup",
        timezone: "Asia/Kolkata",
      },
      key: "schedule:backup:30 * * * *:Asia/Kolkata",
      label: "backup",
      detail: " 30 * * * * Asia/Kolkata",
      describe: "Schedule backup (30 * * * *)",
      icon: "󰃰",
      defaultPollIntervalSec: 15,
      schema: {
        description:
          "A cron schedule: schedule.fired at each time, or one schedule.missed for times that came while sourcefed was stopped",
        properties: {
          cron: {
            type: "string",
            minLength: 1,
            description:
              "A cron expression, e.g. '0 2 * * *' for 02:00 every day",
          },
          job: {
            type: "string",
            minLength: 1,
            description: "The job's name, carried by every event's subject",
          },
          timezone: {
            type: "string",
            description:
              "An IANA time zone, e.g. 'Asia/Kolkata'; the Mac's own when left out",
          },
        },
        required: ["cron", "job"],
      },
      events: [
        {
          source: {
            type: "schedule",
            cron: "30 * * * *",
            job: "backup",
            timezone: "Asia/Kolkata",
          },
          kind: "schedule.missed",
          id: "schedule.missed:backup:2026-11-18T22:30:00+05:30",
          at: "2026-11-18T22:30:00+05:30",
          summary:
            "Schedule backup missed 1 time; the latest was 2026-11-18T22:30:00+05:30",
          body: "Sourcefed was not running, or the Mac was asleep, when these times came. This one event stands for all of them.",
          actionable: true,
          subject: {
            type: "schedule",
            key: "backup",
            job: "backup",
            at: "2026-11-18T22:30:00+05:30",
            cron: "30 * * * *",
            timezone: "Asia/Kolkata",
            missed: 1,
          },
        },
      ],
      cursorAfter: {
        checkedAt: "2026-11-18T17:10:00.000Z",
      },
      terminal: false,
    },
  ],
};
