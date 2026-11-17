FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake make libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt ./
COPY server/ ./server/
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --parallel 2

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates tzdata wget && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home plyt
WORKDIR /app
COPY --from=build /src/build/plyt-server /app/plyt-server
COPY web/ /app/web/
RUN mkdir /app/data && chown -R plyt:plyt /app
USER plyt
ENV PLYT_HOST=0.0.0.0 PORT=8080 TZ=Asia/Seoul
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1
CMD ["/app/plyt-server", "/app"]
