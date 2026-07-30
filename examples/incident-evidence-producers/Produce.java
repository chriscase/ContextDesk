// Minimal Java sketch for Incident Evidence Bundle v1 (directory form).
// javac Produce.java && java Produce

import java.io.*;
import java.nio.file.*;
import java.security.*;

public class Produce {
  static String sha256Hex(Path path) throws Exception {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    try (InputStream in = Files.newInputStream(path)) {
      byte[] buf = new byte[65536];
      int n;
      while ((n = in.read(buf)) > 0) {
        md.update(buf, 0, n);
      }
    }
    StringBuilder sb = new StringBuilder();
    for (byte b : md.digest()) {
      sb.append(String.format("%02x", b));
    }
    return sb.toString();
  }

  public static void main(String[] args) throws Exception {
    Path root = Paths.get("./incident-evidence-out");
    String logRel = "logs/app.log";
    Path logPath = root.resolve(logRel);
    Files.createDirectories(logPath.getParent());
    Files.writeString(logPath, "2024-01-15T12:00:00Z INFO synthetic\n");
    long bytes = Files.size(logPath);
    String hex = sha256Hex(logPath);

    String metricsRel = "metrics/operational-metrics.v1.json";
    Path metricsPath = root.resolve(metricsRel);
    Files.createDirectories(metricsPath.getParent());
    Files.writeString(
        metricsPath,
        """
        {
          "schemaVersion": 1,
          "id": "example-performance",
          "name": "Example performance",
          "series": [
            {
              "id": "cpu-percent",
              "name": "CPU",
              "unit": "%",
              "timeQuality": "wall",
              "provenance": {
                "source": "synthetic/example-performance-monitor",
                "collector": "example-java-collector"
              },
              "points": [
                { "timestamp": 1705312800, "value": 20 },
                { "timestamp": 1705312860, "value": 35 }
              ]
            }
          ]
        }
        """);
    long metricsBytes = Files.size(metricsPath);
    String metricsHex = sha256Hex(metricsPath);

    String manifest =
        "{\n"
            + "  \"schemaId\": \"contextdesk.incident_evidence.v1\",\n"
            + "  \"minReaderVersion\": 1,\n"
            + "  \"bundleId\": \"example-java-bundle\",\n"
            + "  \"createdAt\": \"2024-01-15T12:05:00Z\",\n"
            + "  \"producer\": { \"name\": \"example-java-collector\", \"version\": \"0.1.0\" },\n"
            + "  \"privacy\": {\n"
            + "    \"redactionDeclared\": true,\n"
            + "    \"containsCredentials\": false,\n"
            + "    \"containsPii\": false\n"
            + "  },\n"
            + "  \"timeBasis\": { \"timezone\": \"UTC\", \"timezoneResolved\": true },\n"
            + "  \"components\": [\n"
            + "  {\n"
            + "    \"id\": \"log-app\",\n"
            + "    \"role\": \"log\",\n"
            + "    \"path\": \""
            + logRel
            + "\",\n"
            + "    \"mediaType\": \"text/plain\",\n"
            + "    \"bytes\": "
            + bytes
            + ",\n"
            + "    \"sha256\": \""
            + hex
            + "\",\n"
            + "    \"sourceLabel\": \"app\"\n"
            + "  },\n"
            + "  {\n"
            + "    \"id\": \"metrics-performance\",\n"
            + "    \"role\": \"operational_metrics\",\n"
            + "    \"path\": \""
            + metricsRel
            + "\",\n"
            + "    \"mediaType\": \"application/json\",\n"
            + "    \"bytes\": "
            + metricsBytes
            + ",\n"
            + "    \"sha256\": \""
            + metricsHex
            + "\"\n"
            + "  }\n"
            + "  ]\n"
            + "}\n";
    Files.writeString(root.resolve("manifest.json"), manifest);
    System.err.println("wrote " + root.toAbsolutePath());
  }
}
