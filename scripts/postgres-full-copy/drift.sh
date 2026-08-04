for t in accounts users suppliers purchase_orders invoices; do
  echo -n "$t pg_count="
  sudo -u postgres psql -d tacet -tAc "select count(*) from $t"
done
echo "--- pg supplier id range + checksum ---"
sudo -u postgres psql -d tacet -tAc "select min(id), max(id), count(*), sum(id) from suppliers"
echo "--- pg supplier ids missing vs contiguous ---"
sudo -u postgres psql -d tacet -tAc "select string_agg(id::text, \",\" order by id) from suppliers" | tr "," "\n" | tail -5
