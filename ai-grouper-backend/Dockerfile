# Dockerfile
# Use the official lightweight Python image
FROM python:3.11-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip freeze

# Copy the rest of the application code
COPY . .

# Set the environment variable for Flask to use
ENV FLASK_APP=app.py

# Expose the port (Cloud Run uses PORT environment variable, but 8080 is common practice)
ENV PORT 8080
EXPOSE 8080

# Run the application
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 app:app
