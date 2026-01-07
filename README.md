# Elasticsearch MCP (VSee Fork)

> **Modified MCP server with hardcoded schemas matching VSee's Elasticsearch indexes. Specialized analytics tools optimized for stats-* indices.**

[![npm version](https://badge.fury.io/js/elasticsearch-mcp-vsee.svg)](https://www.npmjs.com/package/elasticsearch-mcp-vsee)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Elasticsearch](https://img.shields.io/badge/Elasticsearch-005571?logo=elasticsearch&logoColor=white)](https://www.elastic.co/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**elasticsearch-mcp-vsee** is a modified Model Context Protocol (MCP) server that provides specialized analytics tools for Elasticsearch clusters, optimized for VSee's stats-* indices. This fork features hardcoded schemas and field names that match VSee's specific Elasticsearch index structure, enabling specialized tools for account/group analytics, visit trends, platform breakdowns, and rating distributions. Built with TypeScript and optimized for Elastic Cloud environments, it offers comprehensive analytics capabilities with enterprise-grade security features.

## 🚀 Features

- **🔐 Secure by Design**: Input validation, script sanitization, injection prevention
- **☁️ Elastic Cloud Ready**: Native support for cloud ID and API key authentication  
- **⚡ High Performance**: Connection pooling, optimized query execution, efficient aggregations
- **🛠️ Comprehensive Tools**: 11 specialized tools for analytics, summaries, and data exploration
- **📊 Advanced Querying**: Full Elasticsearch DSL support with aggregations and highlighting
- **🔍 Smart Validation**: Zod-based schemas with security-first validation
- **📝 Full TypeScript**: Complete type safety with strict null checks

## 🎯 Purpose

This MCP server is designed for **VSee's Open WebUI deployment** to provide specialized analytics tools for querying VSee's Elasticsearch `stats-*` indices. It integrates with VSee's Open WebUI infrastructure via MCPO (MCP OpenAPI bridge) to expose Elasticsearch analytics capabilities to LLMs.

## 📦 Usage with VSee's Open WebUI Deployment

This MCP server is automatically loaded by VSee's Open WebUI deployment through the MCP configuration. It connects to VSee's Elasticsearch deployment to provide analytics on visit statistics, account/group metrics, platform breakdowns, and more.

### Configuration

The MCP server is configured in `vsee/mcp/config.json`:

```json
{
  "mcpServers": {
    "elasticsearch": {
      "command": "npx",
      "args": ["-y", "elasticsearch-mcp-vsee"],
      "env": {
        "ELASTIC_NODE": "https://omtm.es.us-east-1.aws.found.io",
        "ELASTIC_USERNAME": "your-username",
        "ELASTIC_PASSWORD": "your-password",
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

The Open WebUI deployment automatically loads this configuration and starts the MCP server via MCPO, making all 11 tools available to the LLM for querying Elasticsearch data.

## 🔄 Updating and Publishing

### Making Changes

1. **Develop locally**: Make changes to the code in `elasticsearch-mcp/`
2. **Test your changes**: Use `npm run test:tools` to test against your Elasticsearch instance
3. **Build**: Run `npm run build` to compile TypeScript
4. **Publish**: Publish to npm with `npm publish --access public`
   - Make sure to increment the version in `package.json` first

### Updating VSee's Deployment

After publishing a new version to npm:

1. **Update `vsee/mcp/config.json`**: Change the package version in the `args` array:
   ```json
   {
     "mcpServers": {
       "elasticsearch": {
         "command": "npx",
         "args": ["-y", "elasticsearch-mcp-vsee@0.5.0"],  // Update version here
         "env": {
           ...
         }
       }
     }
   }
   ```

2. **Restart the MCPO service**: The MCPO container will automatically download and use the new version on restart:
   ```bash
   docker compose -f docker-compose.vsee.yaml restart mcpo
   ```

3. **Verify**: Check that the new version is loaded by examining the MCPO logs or testing the tools in Open WebUI.

**Note**: You can also use `@latest` to always pull the latest version, but specifying a version number is recommended for production stability.

## 🛠️ Available Tools

| Tool | Description | Use Cases |
|------|-------------|-----------|
| `get_index_fields` | Discover index fields and types | Schema exploration, field discovery |
| `top_change` | Find top accounts or groups with highest visit increase/decrease | Trend analysis, account/group monitoring |
| `get_subscription_breakdown` | Compare subscription tiers with metrics per tier | Subscription-tier analysis and comparisons |
| `get_platform_breakdown` | Platform or platform version breakdown (provider/patient, platform/version) | Platform adoption, device preferences, version analysis |
| `get_rating_distribution` | Rating histograms with statistics | Satisfaction analysis |
| `get_visit_trends` | Time series visit trends (daily/weekly/monthly) | Trend visualization |
| `get_usage_summary` | Comprehensive metrics summary with flexible filtering and grouping | Multi-dimensional analysis and comparisons |

## 📋 Tool Examples

### Get Account Summary

```json
{
  "tool": "get_account_summary",
  "arguments": {
    "account": "example-customer",
    "startDate": "now-1y",
    "endDate": "now"
  }
}
```

### Get Top Accounts by Growth

```json
{
  "tool": "top_change",
  "arguments": {
    "groupBy": "account",
    "direction": "increase",
    "topN": 10,
    "currentPeriodDays": 30,
    "previousPeriodDays": 30
  }
}
```

### Get Platform Breakdown

```json
{
  "tool": "get_platform_breakdown",
  "arguments": {
    "role": "provider",
    "breakdownType": "version",
    "topN": 10,
    "startDate": "now-30d",
    "endDate": "now"
  }
}
```

### Get Visit Trends

```json
{
  "tool": "get_visit_trends",
  "arguments": {
    "interval": "daily",
    "startDate": "now-30d",
    "endDate": "now",
    "groupBy": "subscription"
  }
}
```

## ⚙️ Configuration

### Environment Variables

The MCP server reads configuration from environment variables. These are set in `vsee/mcp/config.json` under the `env` section:

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `ELASTIC_NODE` | Elasticsearch URL | Yes | `https://omtm.es.us-east-1.aws.found.io` |
| `ELASTIC_USERNAME` | Basic auth username | Yes | `your-username` |
| `ELASTIC_PASSWORD` | Basic auth password | Yes | `your-password` |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Disable TLS verification (for self-signed certs) | No | `"0"` |

### Alternative: Elastic Cloud Authentication

If using Elastic Cloud with cloud ID and API key:

| Variable | Description | Required |
|----------|-------------|----------|
| `ELASTIC_CLOUD_ID` | Elastic Cloud deployment ID | Yes* |
| `ELASTIC_API_KEY` | Elasticsearch API key | Yes* |

*Either `ELASTIC_CLOUD_ID` + `ELASTIC_API_KEY` OR `ELASTIC_NODE` + `ELASTIC_USERNAME` + `ELASTIC_PASSWORD` is required

## 🔒 Security Features

### Input Validation
- **Zod Schemas**: Strict type validation for all inputs
- **Field Name Validation**: Prevents reserved field usage
- **Size Limits**: Document size, array length, string length limits
- **Depth Validation**: Prevents deeply nested objects/queries

### Script Security
- **Script Sanitization**: Blocks dangerous script patterns
- **Parameter Validation**: Validates script parameters
- **Execution Limits**: Prevents resource exhaustion

### Query Security
- **Injection Prevention**: Sanitizes and validates all queries
- **Script Query Blocking**: Prevents script-based queries in sensitive operations
- **Rate Limiting**: Protects against abuse

### Data Protection
- **Credential Masking**: Never logs sensitive information
- **Secure Connections**: TLS/SSL support
- **Access Control**: Validates permissions before operations

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   MCP Client    │◄──►│Elasticsearch MCP│◄──►│  Elasticsearch  │
│  (Claude, etc.) │    │     Server      │    │    Cluster      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                       ┌─────────────┐
                       │   Tools     │
                       │             │
                       │ • search    │
                       │ • fields    │
                       │ • summaries │
                       │ • trends    │
                       │ • analytics │
                       └─────────────┘
```

## 📊 Performance

### Benchmarks
- **Search**: <500ms average response time
- **Aggregations**: Optimized for large-scale analytics
- **Memory Usage**: <100MB for typical operations
- **Concurrent Requests**: Up to 10 simultaneous operations

### Optimization Features
- **Connection Pooling**: Reuses Elasticsearch connections
- **Optimized Queries**: Efficient aggregation pipelines
- **Smart Caching**: Reduced redundant queries
- **Health Monitoring**: Automatic reconnection on failures

## 🔧 Development

### Setup Development Environment

```bash
# Install dependencies
npm install

# Set up environment variables
export ELASTIC_NODE="https://your-elasticsearch-url"
export ELASTIC_USERNAME="your-username"
export ELASTIC_PASSWORD="your-password"
export NODE_TLS_REJECT_UNAUTHORIZED="0"  # If needed for self-signed certs

# Run in development mode
npm run dev

# Test tools against live Elasticsearch
npm run test:tools

# Build for production
npm run build

# Publish new version (after incrementing version in package.json)
npm publish --access public
```

### Project Structure

```
elasticsearch-mcp/
├── src/
│   ├── tools/           # MCP tool implementations
│   ├── elasticsearch/   # ES client and connection management
│   ├── validation/      # Input validation schemas
│   ├── errors/          # Error handling utilities
│   ├── config.ts        # Configuration management
│   ├── logger.ts        # Structured logging
│   └── server.ts        # Main MCP server
├── tests/               # Test suite
└── build/               # Compiled output
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🏷️ Version History

- **v0.5.0** - Added `find_entities_by_metric` tool with multi-metric filtering support, updated default limits
- **v0.4.0** - Tool consolidation: merged 14 tools into 11 specialized analytics tools
- **v0.3.0** - Specialized analytics tools for stats-* indices
- Full changelog: [CHANGELOG.md](CHANGELOG.md)

## 🔗 Links

- [npm Package](https://www.npmjs.com/package/elasticsearch-mcp-vsee)
- [Elasticsearch Documentation](https://www.elastic.co/guide/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

**Built for VSee by VSee**