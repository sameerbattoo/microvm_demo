# Contributing to Lambda MicroVM Notebook

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## How to Contribute

### Reporting Bugs

- Use the GitHub Issues tab to report bugs
- Include steps to reproduce, expected behavior, and actual behavior
- Include your environment details (OS, Node.js version, AWS CLI version, Python version)

### Suggesting Features

- Open an issue describing the feature and its use case
- Explain why existing functionality doesn't address the need
- Be specific about the expected behavior

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run the build to verify (`cd web && npm run build`)
5. Run the test suite if applicable (`python3 tests/test_interrupt_execution.py`)
6. Commit with a clear message describing the change
7. Push to your fork and submit a Pull Request

## Development Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- AWS CLI 2.35.10+ (for MicroVM mode)
- AWS account with Lambda MicroVMs access

### Local Development

```bash
# Install dependencies
pip3 install fastapi uvicorn boto3
cd web && npm install

# Run in local dev mode (no AWS needed)
./dev_run.sh

# Run in AWS MicroVM mode
./aws_microvm_run.sh
```

### Project Structure

- `app/` — MicroVM sandbox server (runs inside the VM)
- `proxy/` — Token proxy server (runs on your machine)
- `web/` — React frontend (Vite)
- `scripts/` — AWS setup and build scripts
- `tests/` — End-to-end test scripts

### Running Tests

```bash
# Requires aws_microvm_run.sh to be running
python3 tests/test_interrupt_execution.py
python3 tests/test_microvm_lifecycle.py
python3 tests/test_s3_restore.py
```

## Code Style

### Python
- Follow PEP 8
- Use type hints for function signatures
- Docstrings for public functions and classes
- Keep functions focused and under 50 lines where practical

### JavaScript/React
- Functional components with hooks
- `useCallback` for event handlers passed as props
- `useMemo` for expensive computations
- Descriptive variable names, no abbreviations

### Shell Scripts
- Use `set -euo pipefail`
- Quote all variables
- Add comments for non-obvious logic
- Include idempotency checks (don't recreate existing resources)

## Commit Messages

- Use present tense ("Add feature" not "Added feature")
- First line: concise summary (< 72 chars)
- Body: explain what and why (not how)
- Reference issues where applicable

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
