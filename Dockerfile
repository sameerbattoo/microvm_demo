FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y python3 python3-pip git && dnf clean all

# Use a venv to keep packages isolated
RUN python3 -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# Install sandbox server dependencies
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy application code
WORKDIR /app
COPY app/ ./app/

EXPOSE 8080

CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8080"]
