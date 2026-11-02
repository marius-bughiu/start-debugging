using System.Drawing.Imaging;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--self-test"])
        {
            // Exercise allocation/disposal/PNG encoding without capturing a desktop.
            using var image = new Bitmap(8, 6);
            using (var graphics = Graphics.FromImage(image)) graphics.Clear(Color.CornflowerBlue);
            using var encoded = new MemoryStream();
            image.Save(encoded, ImageFormat.Png);
            encoded.Position = 0;
            using var decoded = Image.FromStream(encoded);
            if (decoded.Width != 8 || decoded.Height != 6) return 1;
            Console.WriteLine("PASS: synthetic bitmap round-trips as PNG; no screen was captured");
            return 0;
        }

        var screen = SystemInformation.VirtualScreen;
        if (screen.Width <= 0 || screen.Height <= 0)
            throw new InvalidOperationException("No desktop bounds are available in this session");
        var directory = args.Length == 1 ? Path.GetFullPath(args[0])
            : Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
        if (string.IsNullOrWhiteSpace(directory))
            throw new InvalidOperationException("Pass an output directory; the Pictures folder is unavailable");
        Directory.CreateDirectory(directory);
        var filename = Path.Combine(directory, $"Screenshot-{DateTime.Now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}.png");
        using var bitmap = new Bitmap(screen.Width, screen.Height);
        using (var graphics = Graphics.FromImage(bitmap))
            graphics.CopyFromScreen(screen.Left, screen.Top, 0, 0, screen.Size, CopyPixelOperation.SourceCopy);
        bitmap.Save(filename, ImageFormat.Png);
        Console.WriteLine(filename);
        return 0;
    }
}
