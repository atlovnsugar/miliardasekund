for f in *.json.gz; do
  gzip -d "$f"  # Rozbalí session_X.json.gz → session_X.json
done