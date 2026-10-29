"""Integration tests for dbui-runner.

Launched by run.sh, which starts postgres:17 (seeded from tests/fixtures/seed.sql) and
redis:7 (seeded from tests/fixtures/redis-seed.txt). Each test starts the runner binary,
writes framed JSON requests to its stdin and checks the framed replies on stdout, the way
Chrome does.
"""

import json
import os
import struct
import subprocess
import threading
import time
import queue

import pytest

RUNNER = os.environ["DBUI_RUNNER_BIN"]
PG_PORT = int(os.environ["DBUI_TEST_PG_PORT"])
REDIS_PORT = int(os.environ["DBUI_TEST_REDIS_PORT"])
PG_PASSWORD = os.environ["DBUI_TEST_PG_PASSWORD"]
TEST_SECRET_REF = "dbui-integration-test-ref"
MAX_MESSAGE = 1024 * 1024


class Runner:
    def __init__(self, env=None):
        full_env = dict(os.environ)
        full_env.update(env or {})
        self.proc = subprocess.Popen(
            [RUNNER, "chrome-extension://test/"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=full_env,
        )
        self.next_id = 0
        self.messages = queue.Queue()
        self.raw_sizes = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        out = self.proc.stdout
        while True:
            header = out.read(4)
            if len(header) < 4:
                self.messages.put(None)
                return
            (length,) = struct.unpack("=I", header)
            body = out.read(length)
            self.raw_sizes.append(length)
            self.messages.put(json.loads(body.decode("utf-8")))

    def send(self, op, **fields):
        self.next_id += 1
        msg = {"id": self.next_id, "op": op, **fields}
        data = json.dumps(msg).encode("utf-8")
        self.proc.stdin.write(struct.pack("=I", len(data)) + data)
        self.proc.stdin.flush()
        return self.next_id

    def recv(self, timeout=20):
        msg = self.messages.get(timeout=timeout)
        assert msg is not None, "runner closed stdout"
        return msg

    def until_final(self, req_id, timeout=30):
        """Collects messages for req_id until one of ok/done/error/objects/schema/secret/hello."""
        got = []
        deadline = time.time() + timeout
        while True:
            msg = self.recv(timeout=max(0.1, deadline - time.time()))
            if msg["id"] != req_id:
                continue
            got.append(msg)
            if msg["type"] not in ("columns", "page"):
                return got

    def call(self, op, **fields):
        return self.until_final(self.send(op, **fields))[-1]

    def close(self):
        self.proc.stdin.close()
        code = self.proc.wait(timeout=10)
        return code


def pg_conn(read_only=False, **extra):
    conn = {
        "driver": "postgres",
        "host": "127.0.0.1",
        "port": PG_PORT,
        "user": "postgres",
        "database": "dbui",
        "readOnly": read_only,
    }
    conn.update(extra)
    return conn


def redis_conn(read_only=False):
    return {"driver": "redis", "host": "127.0.0.1", "port": REDIS_PORT, "readOnly": read_only}


@pytest.fixture
def pg():
    # libpq reads PGPASSWORD, so these tests don't depend on the Keychain.
    r = Runner(env={"PGPASSWORD": PG_PASSWORD})
    ok = r.call("connect", conn=pg_conn())
    assert ok["type"] == "ok", ok
    yield r
    assert r.close() == 0


@pytest.fixture
def pg_ro():
    r = Runner(env={"PGPASSWORD": PG_PASSWORD})
    ok = r.call("connect", conn=pg_conn(read_only=True))
    assert ok["type"] == "ok", ok
    yield r
    assert r.close() == 0


@pytest.fixture
def rd():
    r = Runner()
    assert r.call("connect", conn=redis_conn())["type"] == "ok"
    yield r
    assert r.close() == 0


def rows_of(msgs):
    rows = []
    for m in msgs:
        if m["type"] == "page":
            rows.extend(m["rows"])
    return rows


# ---- lifecycle --------------------------------------------------------------------------


def test_hello_and_clean_exit_on_eof():
    r = Runner()
    hello = r.call("hello", client="test")
    assert hello["type"] == "hello"
    assert hello["protocol"] == 1
    assert "postgres" in hello["drivers"] and "redis" in hello["drivers"]
    assert r.close() == 0
    assert r.proc.stderr.read() == b""


def test_unknown_op_and_not_connected():
    r = Runner()
    assert r.call("nope")["code"] == "UNKNOWN_OP"
    err = r.call("execute", sql="select 1")
    assert err["type"] == "error" and err["code"] == "NOT_CONNECTED"
    assert r.close() == 0


def test_ssh_is_not_implemented():
    r = Runner()
    err = r.call("connect", conn=pg_conn(ssh={"host": "bastion", "user": "deploy"}))
    assert err["code"] == "SSH_NOT_IMPLEMENTED"
    assert r.close() == 0


# ---- postgres ---------------------------------------------------------------------------


def test_pg_connect_reports_server(pg):
    r = Runner(env={"PGPASSWORD": PG_PASSWORD})
    ok = r.call("connect", conn=pg_conn())
    assert ok["server"].startswith("PostgreSQL 17")
    r.close()


def test_pg_bad_password_fails():
    r = Runner(env={"PGPASSWORD": "wrong"})
    err = r.call("connect", conn=pg_conn())
    assert err["type"] == "error" and err["code"] == "CONNECT_FAILED"
    assert "password" in err["message"]
    r.close()


def test_pg_list_objects(pg):
    schemas = pg.call("listObjects", parent=[])["nodes"]
    names = [n["name"] for n in schemas]
    assert "shop" in names and "public" in names
    assert names.index("shop") < names.index("pg_catalog")

    groups = pg.call("listObjects", parent=["shop"])["nodes"]
    assert [g["path"] for g in groups][:2] == [["shop", "tables"], ["shop", "views"]]

    tables = pg.call("listObjects", parent=["shop", "tables"])["nodes"]
    assert [t["name"] for t in tables] == ["customers", "events", "orders"]
    assert tables[0] == {**tables[0], "type": "table", "path": ["shop", "tables", "customers"], "hasChildren": False}

    views = pg.call("listObjects", parent=["shop", "views"])["nodes"]
    assert [v["name"] for v in views] == ["paid_orders"]

    funcs = pg.call("listObjects", parent=["shop", "functions"])["nodes"]
    assert funcs[0]["name"] == "order_count(c bigint)"
    assert funcs[0]["meta"] == "bigint"


def test_pg_describe(pg):
    schema = pg.call("describe", path=["shop", "tables", "orders"])["schema"]
    cols = {c["name"]: c for c in schema["columns"]}
    assert cols["id"]["primaryKey"] is True and cols["id"]["type"] == "bigint"
    assert cols["customer_id"]["references"] == "customers.id"
    assert cols["status"]["enumValues"] == ["pending", "paid", "shipped"]
    assert cols["weight"]["nullable"] is True and cols["qty"]["nullable"] is False
    assert cols["paid"]["default"] == "false"
    idx = {i["name"]: i for i in schema["indexes"]}
    assert idx["orders_pkey"]["primary"] is True
    assert idx["orders_customer_idx"]["columns"] == ["customer_id"]
    assert schema["ddl"].startswith('CREATE TABLE "shop"."orders" (')
    assert "FOREIGN KEY (customer_id) REFERENCES shop.customers(id)" in schema["ddl"]

    view = pg.call("describe", path=["shop", "views", "paid_orders"])["schema"]
    assert view["ddl"].startswith('CREATE VIEW "shop"."paid_orders" AS')

    fn = pg.call("describe", path=["shop", "functions", "order_count(c bigint)"])["schema"]
    assert "CREATE OR REPLACE FUNCTION shop.order_count" in fn["ddl"]

    missing = pg.call("describe", path=["shop", "tables", "nope"])
    assert missing["code"] == "NOT_FOUND"


def test_pg_type_mapping(pg):
    msgs = pg.until_final(
        pg.send("execute", sql="select id, total, paid, qty, weight, meta, status from shop.orders order by id")
    )
    cols = msgs[0]["cols"]
    assert [c["type"] for c in cols] == ["int8", "numeric", "bool", "int4", "float8", "jsonb", "order_status"]
    rows = rows_of(msgs)
    assert rows[0] == ["1", "12.50", True, 2, 1.25, {"source": "web", "tags": ["a", "b"]}, "paid"]
    assert rows[1][4] is None and rows[1][5] is None
    assert rows[2][1] == "9007199254740993.10"
    assert msgs[-1]["type"] == "done" and msgs[-1]["rowCount"] == 3


def test_pg_params(pg):
    msgs = pg.until_final(pg.send("execute", sql="select email from shop.customers where id = $1", params=[2]))
    assert rows_of(msgs) == [["bob@example.com"]]


def test_pg_execute_paging_under_1mb(pg):
    msgs = pg.until_final(pg.send("execute", sql="select * from shop.events order by id", pageSize=2000))
    pages = [m for m in msgs if m["type"] == "page"]
    # 5000 rows × ~2 KB ≈ 10 MB: must split by size, not just by the 2000-row page size.
    assert len(pages) >= 10
    assert [p["seq"] for p in pages] == list(range(len(pages)))
    assert all(len(p["rows"]) <= 2000 for p in pages)
    assert max(pg.raw_sizes) < MAX_MESSAGE
    rows = rows_of(msgs)
    assert len(rows) == 5000 and rows[-1][0] == 5000
    assert msgs[-1]["rowCount"] == 5000


def test_pg_page_size(pg):
    msgs = pg.until_final(pg.send("execute", sql="select g from generate_series(1, 25) g", pageSize=10))
    assert [len(m["rows"]) for m in msgs if m["type"] == "page"] == [10, 10, 5]


def test_pg_error_has_sqlstate(pg):
    err = pg.call("execute", sql="select * from shop.nope")
    assert err["type"] == "error" and err["code"] == "42P01"
    # The connection still works afterwards.
    assert pg.call("execute", sql="select 1")["type"] == "done"


def test_pg_command_reports_affected_rows(pg):
    done = pg.call("execute", sql="update shop.customers set name = name where id <= 2")
    assert done["type"] == "done" and done["affectedRows"] == 2 and done["rowCount"] == 0


def test_pg_cancel_sleep(pg):
    started = time.time()
    exec_id = pg.send("execute", sql="select pg_sleep(30)")
    time.sleep(0.5)
    cancel_id = pg.send("cancel", target=exec_id)
    got = {}
    while len(got) < 2:
        m = pg.recv(timeout=10)
        if m["id"] in (exec_id, cancel_id) and m["type"] not in ("columns", "page"):
            got[m["id"]] = m
    assert got[cancel_id]["type"] == "ok" and got[cancel_id]["cancelled"] is True
    assert got[exec_id]["type"] == "error" and got[exec_id]["code"] == "CANCELLED"
    assert time.time() - started < 5
    assert pg.call("execute", sql="select 1")["type"] == "done"


def test_pg_tree_works_during_long_query(pg):
    exec_id = pg.send("execute", sql="select pg_sleep(3)")
    time.sleep(0.3)
    started = time.time()
    nodes = pg.call("listObjects", parent=["shop", "tables"])
    assert nodes["type"] == "objects"
    assert time.time() - started < 2  # served by the metadata connection
    pg.send("cancel", target=exec_id)
    pg.until_final(exec_id)


def test_pg_apply_in_one_transaction(pg):
    ok = pg.call(
        "apply",
        statements=[
            {"sql": 'INSERT INTO "shop"."customers" ("email", "name") VALUES ($1, $2)', "params": ["dee@example.com", "Dee"]},
            {"sql": 'UPDATE "shop"."customers" SET "name" = $1 WHERE "id" = $2', "params": ["Bobby", "2"]},
        ],
    )
    assert ok["type"] == "ok" and ok["applied"] == 2
    rows = rows_of(pg.until_final(pg.send("execute", sql="select name from shop.customers where id = 2 or email = 'dee@example.com' order by id")))
    assert rows == [["Bobby"], ["Dee"]]

    # Second statement fails → the first is rolled back.
    err = pg.call(
        "apply",
        statements=[
            {"sql": 'UPDATE "shop"."customers" SET "name" = $1 WHERE "id" = $2', "params": ["Rolled", "1"]},
            {"sql": 'INSERT INTO "shop"."customers" ("email") VALUES ($1)', "params": ["ada@example.com"]},
        ],
    )
    assert err["type"] == "error" and err["code"] == "23505"
    assert "statement 2" in err["message"]
    rows = rows_of(pg.until_final(pg.send("execute", sql="select name from shop.customers where id = 1")))
    assert rows == [["Ada"]]


def test_pg_read_only_refuses_writes(pg_ro):
    err = pg_ro.call("execute", sql="delete from shop.orders")
    assert err["type"] == "error" and err["code"] == "25006"  # read_only_sql_transaction
    err = pg_ro.call("execute", sql="set default_transaction_read_only = off")
    assert err["code"] == "READ_ONLY"
    err = pg_ro.call("execute", sql="begin read write")
    assert err["code"] == "READ_ONLY"
    err = pg_ro.call("apply", statements=[{"sql": "delete from shop.orders"}])
    assert err["code"] == "READ_ONLY"
    assert pg_ro.call("execute", sql="select count(*) from shop.orders")["type"] == "done"


# ---- redis ------------------------------------------------------------------------------


def test_redis_connect_and_list(rd):
    nodes = rd.call("listObjects", parent=[])["nodes"]
    by_name = {n["name"]: n for n in nodes}
    assert {"greeting", "counter", "session:1", "session:2", "queue:jobs", "tags", "leaderboard"} <= set(by_name)
    assert by_name["session:1"]["meta"] == "hash"
    assert by_name["session:2"]["meta"].startswith("hash · ttl ")
    assert by_name["queue:jobs"]["type"] == "key"

    sessions = rd.call("listObjects", parent=["session:"])["nodes"]
    assert [n["name"] for n in sessions] == ["session:1", "session:2"]


def test_redis_execute(rd):
    msgs = rd.until_final(rd.send("execute", sql="HGETALL session:1"))
    assert [c["name"] for c in msgs[0]["cols"]] == ["field", "value"]
    assert sorted(rows_of(msgs)) == [["role", "admin"], ["theme", "dark"], ["user", "ada"]]

    msgs = rd.until_final(rd.send("execute", sql="ZRANGE leaderboard 0 -1 WITHSCORES"))
    assert rows_of(msgs) == [["cy", 70.0], ["bob", 85.5], ["ada", 100.0]]

    msgs = rd.until_final(rd.send("execute", sql="LRANGE queue:jobs 0 -1"))
    assert rows_of(msgs) == [[0, "job-1"], [1, "job-2"], [2, "job-3"]]

    msgs = rd.until_final(rd.send("execute", sql='GET "greeting"'))
    assert rows_of(msgs) == [["hello world"]]

    err = rd.call("execute", sql="HGETALL")
    assert err["type"] == "error" and "wrong number" in err["message"]


def test_redis_describe(rd):
    schema = rd.call("describe", path=["leaderboard"])["schema"]
    assert [c["name"] for c in schema["columns"]] == ["member", "score"]
    assert schema["info"]["type"] == "zset"


def test_redis_apply_multi_exec(rd):
    ok = rd.call(
        "apply",
        statements=[
            {"sql": "HSET", "params": ["session:1", "theme", "light"]},
            {"sql": "INCR", "params": ["counter"]},
        ],
    )
    assert ok["type"] == "ok" and ok["applied"] == 2
    assert rows_of(rd.until_final(rd.send("execute", sql="GET counter"))) == [["42"]]
    rd.call("execute", sql="HSET session:1 theme dark")


def test_redis_cancel_blocking_command(rd):
    exec_id = rd.send("execute", sql="BLPOP nothing-here 30")
    time.sleep(0.5)
    rd.send("cancel", target=exec_id)
    final = rd.until_final(exec_id, timeout=5)[-1]
    assert final["type"] == "error" and final["code"] == "CANCELLED"
    # Reconnects for the next command.
    assert rows_of(rd.until_final(rd.send("execute", sql="GET greeting"))) == [["hello world"]]


def test_redis_read_only_refuses_writes():
    r = Runner()
    assert r.call("connect", conn=redis_conn(read_only=True))["type"] == "ok"
    for cmd in ("SET greeting bye", "del greeting", "FLUSHALL", "EVAL 'return 1' 0"):
        err = r.call("execute", sql=cmd)
        assert err["type"] == "error" and err["code"] == "READ_ONLY", cmd
    assert r.call("apply", statements=[{"sql": "SET", "params": ["a", "b"]}])["code"] == "READ_ONLY"
    assert rows_of(r.until_final(r.send("execute", sql="GET greeting"))) == [["hello world"]]
    assert r.close() == 0


# ---- keychain ---------------------------------------------------------------------------


def test_secret_set_get_delete_and_connect_with_secret_ref():
    r = Runner()
    try:
        ok = r.call("secret.set", ref=TEST_SECRET_REF, value=PG_PASSWORD)
        if ok["type"] == "error":
            pytest.skip(f"Keychain unavailable here: {ok['message']}")
        assert r.call("secret.get", ref=TEST_SECRET_REF) == {"id": r.next_id, "type": "secret", "value": PG_PASSWORD}

        # connect reads the password from the Keychain (PGPASSWORD is not set for this runner).
        ok = r.call("connect", conn=pg_conn(secretRef=TEST_SECRET_REF))
        assert ok["type"] == "ok", ok
    finally:
        deleted = r.call("secret.delete", ref=TEST_SECRET_REF)
    assert deleted["type"] == "ok" and deleted["deleted"] is True
    assert r.call("secret.get", ref=TEST_SECRET_REF)["value"] is None
    assert r.call("secret.delete", ref=TEST_SECRET_REF)["deleted"] is False
    err = r.call("connect", conn=pg_conn(secretRef=TEST_SECRET_REF))
    assert err["code"] == "SECRET_NOT_FOUND"
    assert r.close() == 0
