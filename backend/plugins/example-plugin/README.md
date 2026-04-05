# Example Plugin

A simple demonstration plugin for Claudia.

## Features

- Adds a `/plugins/example-plugin/hello` endpoint
- Demonstrates plugin initialization and routing
- Shows how to use the plugin context

## Testing

After starting Claudia, test the plugin:

```bash
# Get hello message
curl -k https://localhost:4001/plugins/example-plugin/hello

# Echo endpoint
curl -k -X POST https://localhost:4001/plugins/example-plugin/echo \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

## Structure

- `plugin.json` - Plugin manifest
- `index.js` - Plugin implementation
- `README.md` - This file

## Extending

Use this as a template for creating your own plugins!
