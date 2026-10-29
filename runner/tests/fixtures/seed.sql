-- Seed data for the runner integration tests (tests/integration/run.sh).
create schema shop;

create type shop.order_status as enum ('pending', 'paid', 'shipped');

create table shop.customers (
  id         bigserial primary key,
  email      text not null unique,
  name       text,
  created_at timestamptz not null default '2024-01-01 00:00:00+00'
);

create table shop.orders (
  id          bigserial primary key,
  customer_id bigint not null references shop.customers (id),
  status      shop.order_status not null default 'pending',
  total       numeric(20, 2) not null,
  paid        boolean not null default false,
  qty         integer not null,
  weight      double precision,
  meta        jsonb
);
create index orders_customer_idx on shop.orders (customer_id);

create view shop.paid_orders as select id, customer_id, total from shop.orders where paid;

create function shop.order_count(c bigint) returns bigint language sql stable
as $$ select count(*) from shop.orders where customer_id = c $$;

insert into shop.customers (email, name) values
  ('ada@example.com', 'Ada'),
  ('bob@example.com', 'Bob'),
  ('cy@example.com', null);

insert into shop.orders (customer_id, status, total, paid, qty, weight, meta) values
  (1, 'paid', 12.50, true, 2, 1.25, '{"source": "web", "tags": ["a", "b"]}'),
  (1, 'pending', 99.99, false, 1, null, null),
  (2, 'shipped', 9007199254740993.10, true, 3, 0.5, '{"source": "app"}');

-- 5000 rows of ~2 KB each (~10 MB) to exercise paging and the 1 MB message split.
create table shop.events (
  id      int primary key,
  payload text not null
);
insert into shop.events select g, repeat(md5(g::text), 64) from generate_series(1, 5000) g;
