import os

TENANT_ID = "46662032-87fa-42c7-9b94-0083086bbd46"
BASE = f"/home/humbrol2/commander-v3/data/tenants/{TENANT_ID}"
CONFIG = f"{BASE}/config.toml"

# Read existing config
with open(CONFIG, "r") as f:
    content = f.read()

# Add database and redis sections if not present
if "[database]" not in content:
    content += """
[database]
url = "postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander"
driver = "postgresql"

[redis]
url = "redis://:7e23dd7cf7c7aea497add4e479173480@10.0.0.54:6379"
enabled = true
"""

with open(CONFIG, "w") as f:
    f.write(content)

print(f"Updated {CONFIG}")

# Update the systemd service to pass tenant-id and database-url
service = f"""[Unit]
Description=SpaceMolt Commander v3
After=network.target

[Service]
Type=simple
User=humbrol2
Group=humbrol2
WorkingDirectory=/home/humbrol2/commander-v3
Environment=BUN_INSTALL=/home/humbrol2/.bun
Environment=PATH=/home/humbrol2/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=JWT_SECRET=spacemolt-commander-jwt-secret-2026
ExecStart=/home/humbrol2/.bun/bin/bun run src/app.ts --config {BASE}/config.toml --database-url postgresql://humbrol2:3e1779ab4980bd4c7133eb457f8d3a0b@10.0.0.54:5432/commander --redis-url redis://:7e23dd7cf7c7aea497add4e479173480@10.0.0.54:6379 --tenant-id {TENANT_ID} --port 4000 --log-dir {BASE}/logs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
"""

with open("/etc/systemd/system/commander.service", "w") as f:
    f.write(service)

print("Updated commander.service")
