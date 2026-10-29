"""Records real runner sessions into extension/tests/fixtures/runner/sessions.json, which the
extension's RunnerDriver tests replay through a fake chrome.runtime.connectNative port.

Run through run.sh so the containers exist:
    runner/tests/integration/run.sh --record
Each exchange is {"request": <request without id>, "responses": [<messages without id>]}.
For a cancelled request, "responses" holds what came before the cancel and "afterCancel"
what came after it.
"""

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from test_runner import Runner, pg_conn, redis_conn, PG_PASSWORD  # noqa: E402

OUT = Path(__file__).resolve().parents[3] / "extension/tests/fixtures/runner/sessions.json"


def strip(msg):
    msg = {k: v for k, v in msg.items() if k != "id"}
    if "ms" in msg:
        msg["ms"] = 5  # keep the fixture stable between recordings
    return msg


def record(runner, steps):
    exchanges = []
    for op, fields in steps:
        if op == "cancel-sleep":
            exec_id = runner.send("execute", **fields)
            time.sleep(0.5)
            cancel_id = runner.send("cancel", target=exec_id)
            cancel_msgs, after = [], []
            while not (cancel_msgs and after and after[-1]["type"] not in ("columns", "page")):
                m = runner.recv()
                if m["id"] == cancel_id:
                    cancel_msgs.append(m)
                elif m["id"] == exec_id:
                    after.append(m)
            exchanges.append({"request": {"op": "execute", **fields}, "responses": [], "afterCancel": [strip(m) for m in after]})
            exchanges.append({"request": {"op": "cancel", "target": "<previous>"}, "responses": [strip(m) for m in cancel_msgs]})
            continue
        req_id = runner.send(op, **fields)
        msgs = runner.until_final(req_id)
        exchanges.append({"request": {"op": op, **fields}, "responses": [strip(m) for m in msgs]})
    return exchanges


def main():
    pg = Runner(env={"PGPASSWORD": PG_PASSWORD})
    pg_conn_req = {k: v for k, v in pg_conn().items()}
    postgres = record(
        pg,
        [
            ("hello", {"client": "0.1.0"}),
            ("connect", {"conn": pg_conn_req}),
            ("listObjects", {"parent": []}),
            ("listObjects", {"parent": ["shop", "tables"]}),
            ("describe", {"path": ["shop", "tables", "customers"]}),
            ("execute", {"sql": "select id, total, paid, qty, weight, meta from shop.orders order by id", "pageSize": 2}),
            ("execute", {"sql": "select * from shop.nope", "pageSize": 2000}),
            ("cancel-sleep", {"sql": "select pg_sleep(30)", "pageSize": 2000}),
            (
                "apply",
                {
                    "statements": [
                        {"sql": 'UPDATE "shop"."customers" SET "name" = $1 WHERE "id" = $2', "params": ["Bobby", "2"]},
                        {"sql": 'DELETE FROM "shop"."customers" WHERE "id" = $1', "params": ["3"]},
                    ]
                },
            ),
        ],
    )
    pg.close()

    rd = Runner()
    redis = record(
        rd,
        [
            ("hello", {"client": "0.1.0"}),
            ("connect", {"conn": redis_conn()}),
            ("listObjects", {"parent": ["session:"]}),
            ("execute", {"sql": "HGETALL session:1", "pageSize": 2000}),
            (
                "apply",
                {"statements": [{"sql": "HSET", "params": ["session:1", "theme", "light"]}, {"sql": "HDEL", "params": ["session:1", "role"]}]},
            ),
        ],
    )
    rd.close()


    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "_comment": "Recorded from dbui-runner by runner/tests/integration/record_fixture.py. Do not edit by hand.",
        "postgres": postgres,
        "redis": redis,
    }
    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
