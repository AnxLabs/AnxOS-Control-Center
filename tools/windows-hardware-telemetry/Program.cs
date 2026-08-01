using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32;
using LibreHardwareMonitor.Hardware;

static bool Valid(float? value) => value is > 0 and <= 125 && !float.IsNaN(value.Value) && !float.IsInfinity(value.Value);

static object Sensor(ISensor sensor) => new
{
    name = sensor.Name,
    identifier = sensor.Identifier.ToString(),
    hardware = sensor.Hardware.Name,
    hardwareType = sensor.Hardware.HardwareType.ToString(),
    sensorType = sensor.SensorType.ToString(),
    value = sensor.Value,
};

Computer? computer = null;
try
{
    // This helper exists only to provide CPU temperature to the Runtime card.
    // Enabling unrelated hardware makes LibreHardwareMonitor initialize extra
    // buses and drivers, which can delay or stall the first response on some
    // Windows systems. Keep discovery deliberately CPU-only.
    computer = new Computer { IsCpuEnabled = true };
    computer.Open();
    var visitor = new UpdateVisitor();
    var principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
    var elevated = principal.IsInRole(WindowsBuiltInRole.Administrator);

    while (Console.ReadLine() is not null)
    {
        computer.Accept(visitor);
        var allHardware = computer.Hardware.SelectMany(h => new[] { h }.Concat(h.SubHardware)).ToArray();
        var allSensors = allHardware.SelectMany(h => h.Sensors).ToArray();
        var cpuHardwareEnumerated = allHardware.Any(h => h.HardwareType == HardwareType.Cpu);
        var cpuTemperatureSensorsEnumerated = allSensors.Count(s => s.SensorType == SensorType.Temperature && s.Hardware.HardwareType == HardwareType.Cpu);
        using var pawnIoKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\PawnIO");
        var pawnIoInstalled = pawnIoKey is not null;
        var sensors = allSensors
            .Where(s => s.SensorType == SensorType.Temperature && Valid(s.Value))
            .Select(Sensor)
            .ToArray();
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            ok = true,
            source = "Embedded LibreHardwareMonitor",
            timestamp = DateTimeOffset.UtcNow,
            elevated,
            cpuHardwareEnumerated,
            cpuTemperatureSensorsEnumerated,
            pawnIoInstalled,
            sensors,
        }));
        Console.Out.Flush();
    }
}
catch (Exception error)
{
    var accessDenied = error is UnauthorizedAccessException ||
        error.Message.Contains("access", StringComparison.OrdinalIgnoreCase) ||
        error.Message.Contains("driver", StringComparison.OrdinalIgnoreCase);
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        ok = false,
        source = "Embedded LibreHardwareMonitor",
        timestamp = DateTimeOffset.UtcNow,
        reason = accessDenied ? "access_denied_or_driver_unavailable" : "provider_failed",
        message = error.Message,
    }));
    Environment.ExitCode = 2;
}
finally
{
    computer?.Close();
}

sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);
    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (var subHardware in hardware.SubHardware) subHardware.Accept(this);
    }
    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}
