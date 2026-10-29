-- weekly paid orders per customer
select c.email, count(*) as orders, sum(o.total) as revenue from orders o join customers c on c.id = o.customer_id where o.status = 'paid' and o.created_at >= $1 group by c.email order by revenue desc limit 50;
/* second statement */ select 'it''s', 3.5e2, `weird name` from t;
