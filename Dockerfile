# One image: the client built into the API's wwwroot (pm-board DD-006).

FROM node:22-slim AS client
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
# The glossary module is shared with the CLI and imported from ../shared.
COPY shared/ /src/shared/
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS server
WORKDIR /src/server
COPY server/ ./
RUN dotnet publish src/PmBoard.Api/PmBoard.Api.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=server /out ./
COPY --from=client /src/client/dist ./wwwroot
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER app
ENTRYPOINT ["dotnet", "PmBoard.Api.dll"]
