import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

const items = Array.from({ length: 7 }, (_, index) => `Item ${index + 1}`);

export default function App() {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.heading}>Two-column layout</Text>
      <View style={styles.container}>
        {items.map((label) => (
          <View key={label} style={styles.itemContainer}>
            <View style={styles.item} accessibilityLabel={label}>
              <Text style={styles.label}>{label}</Text>
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 16, backgroundColor: '#f6f8fc' },
  heading: { marginBottom: 16, fontSize: 24, fontWeight: '600', color: '#182338' },
  container: { flexDirection: 'row', flexWrap: 'wrap', alignContent: 'flex-start' },
  itemContainer: { width: '50%', height: 100, padding: 8 },
  item: { flex: 1, padding: 8, justifyContent: 'center', backgroundColor: '#dde8f6', borderRadius: 8 },
  label: { color: '#182338', fontSize: 16 },
});
