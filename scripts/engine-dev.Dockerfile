# A local build image for the engine: the .NET SDK with the native
# toolchain NativeAOT needs. CI uses GitHub's runners instead.
FROM mcr.microsoft.com/dotnet/sdk:10.0
RUN apt-get update && apt-get install -y --no-install-recommends clang zlib1g-dev binutils && rm -rf /var/lib/apt/lists/*
